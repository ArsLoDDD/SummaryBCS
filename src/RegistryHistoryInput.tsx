import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type InputHTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";
import { filterRegistryHistoryValues } from "./registryHistory";

interface Props extends Omit<InputHTMLAttributes<HTMLInputElement>, "list" | "onChange" | "value"> {
  ariaLabel: string;
  value: string;
  options: ReadonlyArray<string>;
  onChange: (value: string) => void;
}

export interface RegistryHistoryKeyAction {
  activeIndex: number;
  open: boolean;
  preventDefault: boolean;
  selectedIndex: number | null;
}

/** Pure keyboard navigation shared by the component and its focused unit tests. */
export function getRegistryHistoryKeyAction(
  key: string,
  open: boolean,
  activeIndex: number,
  optionCount: number,
): RegistryHistoryKeyAction | null {
  if (key === "Escape") {
    return { activeIndex, open: false, preventDefault: open, selectedIndex: null };
  }

  if (key === "ArrowDown" || key === "ArrowUp") {
    if (optionCount === 0) {
      return { activeIndex: -1, open: true, preventDefault: true, selectedIndex: null };
    }

    if (!open || activeIndex < 0 || activeIndex >= optionCount) {
      return {
        activeIndex: key === "ArrowDown" ? 0 : optionCount - 1,
        open: true,
        preventDefault: true,
        selectedIndex: null,
      };
    }

    const direction = key === "ArrowDown" ? 1 : -1;
    return {
      activeIndex: (activeIndex + direction + optionCount) % optionCount,
      open: true,
      preventDefault: true,
      selectedIndex: null,
    };
  }

  if (key === "Enter" && open && activeIndex >= 0 && activeIndex < optionCount) {
    return {
      activeIndex,
      open: false,
      preventDefault: true,
      selectedIndex: activeIndex,
    };
  }

  return null;
}

/**
 * Editable autocomplete used for registry history fields. The user may choose a
 * previous value or keep any newly typed text. Its menu lives under document.body
 * so modal boundaries can never clip it.
 */
export default function RegistryHistoryInput({
  ariaLabel,
  value,
  options,
  onChange,
  className,
  disabled = false,
  onClick: externalOnClick,
  onFocus: externalOnFocus,
  onKeyDown: externalOnKeyDown,
  ...inputProps
}: Props) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [menuStyle, setMenuStyle] = useState<CSSProperties>({});
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const matchingOptions = useMemo(
    () => filterRegistryHistoryValues(options, value),
    [options, value],
  );
  const activeOptionId = activeIndex >= 0 ? `${listId}-option-${activeIndex}` : undefined;

  const showMenu = useCallback(() => {
    if (disabled) return;
    const selectedIndex = matchingOptions.findIndex((option) => option === value);
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : matchingOptions.length > 0 ? 0 : -1);
    setOpen(true);
  }, [disabled, matchingOptions, value]);

  const choose = useCallback((option: string) => {
    onChange(option);
    setOpen(false);
    setActiveIndex(-1);
    inputRef.current?.focus();
  }, [onChange]);

  useEffect(() => {
    if (!open) return;

    function closeOutside(event: MouseEvent) {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target)) {
        setOpen(false);
        setActiveIndex(-1);
      }
    }

    document.addEventListener("mousedown", closeOutside);
    return () => document.removeEventListener("mousedown", closeOutside);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const selectedIndex = matchingOptions.findIndex((option) => option === value);
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : matchingOptions.length > 0 ? 0 : -1);
  }, [matchingOptions, open, value]);

  const updateMenuPosition = useCallback(() => {
    if (!open || !inputRef.current) return;
    const rect = inputRef.current.getBoundingClientRect();
    const viewportWidth = document.documentElement.clientWidth;
    const viewportHeight = document.documentElement.clientHeight;
    const edge = 8;
    const gap = 5;
    const width = Math.min(Math.max(rect.width, 250), Math.max(0, viewportWidth - edge * 2));
    const left = Math.min(Math.max(edge, rect.left), Math.max(edge, viewportWidth - width - edge));
    const estimatedHeight = Math.min(260, Math.max(52, matchingOptions.length * 42 + 10));
    const availableBelow = viewportHeight - rect.bottom - edge;
    const availableAbove = rect.top - edge;
    const placeAbove = availableBelow < Math.min(estimatedHeight, 160) && availableAbove > availableBelow;
    const maxHeight = Math.max(80, Math.min(260, (placeAbove ? availableAbove : availableBelow) - gap));

    setMenuStyle(placeAbove
      ? {
          position: "fixed",
          top: "auto",
          right: "auto",
          bottom: viewportHeight - rect.top + gap,
          left,
          width,
          maxHeight,
        }
      : {
          position: "fixed",
          top: rect.bottom + gap,
          right: "auto",
          bottom: "auto",
          left,
          width,
          maxHeight,
        });
  }, [matchingOptions.length, open]);

  useLayoutEffect(() => {
    if (!open) return;
    updateMenuPosition();
    window.addEventListener("resize", updateMenuPosition);
    window.addEventListener("scroll", updateMenuPosition, true);
    return () => {
      window.removeEventListener("resize", updateMenuPosition);
      window.removeEventListener("scroll", updateMenuPosition, true);
    };
  }, [open, updateMenuPosition]);

  useEffect(() => {
    if (!open || activeIndex < 0) return;
    const activeOption = menuRef.current?.querySelector<HTMLElement>(`[data-option-index="${activeIndex}"]`);
    activeOption?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, open]);

  function handleKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    externalOnKeyDown?.(event);
    if (event.defaultPrevented || disabled) return;

    const action = getRegistryHistoryKeyAction(
      event.key,
      open,
      activeIndex,
      matchingOptions.length,
    );
    if (!action) return;
    if (action.preventDefault) event.preventDefault();
    if (action.selectedIndex !== null) {
      const option = matchingOptions[action.selectedIndex];
      if (option !== undefined) choose(option);
      return;
    }
    setOpen(action.open);
    setActiveIndex(action.activeIndex);
  }

  const menu = open ? (
    <div
      ref={menuRef}
      id={listId}
      className="registry-history-menu"
      role="listbox"
      aria-label={`${ariaLabel}: попередні значення`}
      style={menuStyle}
    >
      {matchingOptions.length > 0 ? matchingOptions.map((option, index) => {
        const selected = option === value;
        return (
          <button
            type="button"
            id={`${listId}-option-${index}`}
            key={option}
            role="option"
            aria-selected={selected}
            data-option-index={index}
            className={`registry-history-option${selected ? " selected" : ""}${activeIndex === index ? " active" : ""}`}
            onMouseDown={(event) => event.preventDefault()}
            onMouseEnter={() => setActiveIndex(index)}
            onClick={() => choose(option)}
          >
            <span>{option}</span>
            {selected && <Check size={16} aria-hidden="true" />}
          </button>
        );
      }) : (
        <div className="registry-history-empty">Збігів немає — введене значення можна зберегти</div>
      )}
    </div>
  ) : null;

  return (
    <div ref={rootRef} className={`registry-history-combobox${open ? " open" : ""}`}>
      <input
        {...inputProps}
        ref={inputRef}
        type="text"
        className={className}
        role="combobox"
        aria-label={ariaLabel}
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={open ? activeOptionId : undefined}
        autoComplete="off"
        disabled={disabled}
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
          if (!open && !disabled) setOpen(true);
        }}
        onClick={(event) => {
          externalOnClick?.(event);
          if (!event.defaultPrevented) showMenu();
        }}
        onFocus={(event) => {
          externalOnFocus?.(event);
          if (!event.defaultPrevented) showMenu();
        }}
        onKeyDown={handleKeyDown}
      />
      <ChevronDown className="registry-history-chevron" size={17} aria-hidden="true" />
      {typeof document !== "undefined" ? createPortal(menu, document.body) : menu}
    </div>
  );
}
