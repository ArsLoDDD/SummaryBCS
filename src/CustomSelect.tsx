import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";

export interface CustomSelectOption<T extends string = string> {
  value: T;
  label: string;
  disabled?: boolean;
}

interface Props<T extends string> {
  ariaLabel: string;
  value: T | "";
  options: ReadonlyArray<CustomSelectOption<T>>;
  onChange: (value: T) => void;
  placeholder?: string;
  disabled?: boolean;
  portal?: boolean;
}

export default function CustomSelect<T extends string>({
  ariaLabel,
  value,
  options,
  onChange,
  placeholder = "Оберіть",
  disabled = false,
  portal = false,
}: Props<T>) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [portalStyle, setPortalStyle] = useState<CSSProperties>({});
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const enabledOptions = useMemo(() => options.filter((option) => !option.disabled), [options]);
  const selected = options.find((option) => option.value === value);

  useEffect(() => {
    function closeOutside(event: MouseEvent) {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false);
    }
    document.addEventListener("mousedown", closeOutside);
    return () => document.removeEventListener("mousedown", closeOutside);
  }, []);

  const updatePortalPosition = useCallback(() => {
    if (!portal || !open || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const viewportWidth = document.documentElement.clientWidth;
    const viewportHeight = document.documentElement.clientHeight;
    const edge = 8;
    const gap = 5;
    const width = Math.min(Math.max(rect.width, 250), Math.max(0, viewportWidth - edge * 2));
    const left = Math.min(Math.max(edge, rect.left), Math.max(edge, viewportWidth - width - edge));
    const availableBelow = viewportHeight - rect.bottom - edge;
    const availableAbove = rect.top - edge;
    const estimatedHeight = Math.min(260, options.length * 42 + 10);
    const placeAbove = availableBelow < Math.min(estimatedHeight, 160) && availableAbove > availableBelow;
    const maxHeight = Math.max(96, Math.min(260, (placeAbove ? availableAbove : availableBelow) - gap));

    setPortalStyle(placeAbove
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
  }, [open, options.length, portal]);

  useLayoutEffect(() => {
    if (!portal || !open) return;
    updatePortalPosition();
    window.addEventListener("resize", updatePortalPosition);
    window.addEventListener("scroll", updatePortalPosition, true);
    return () => {
      window.removeEventListener("resize", updatePortalPosition);
      window.removeEventListener("scroll", updatePortalPosition, true);
    };
  }, [open, portal, updatePortalPosition]);

  function openMenu() {
    if (disabled) return;
    const selectedIndex = enabledOptions.findIndex((option) => option.value === value);
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : 0);
    setOpen(true);
  }

  function choose(option: CustomSelectOption<T>) {
    if (option.disabled) return;
    onChange(option.value);
    setOpen(false);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
    if (disabled) return;
    if (event.key === "Escape") {
      setOpen(false);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (!open) openMenu();
      else if (enabledOptions[activeIndex]) choose(enabledOptions[activeIndex]);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) {
        openMenu();
        return;
      }
      const direction = event.key === "ArrowDown" ? 1 : -1;
      const next = (activeIndex + direction + enabledOptions.length) % enabledOptions.length;
      setActiveIndex(next);
    }
  }

  const menu = open ? (
    <div
      ref={menuRef}
      id={listId}
      className={`custom-select-menu${portal ? " custom-select-menu-portal" : ""}`}
      role="listbox"
      aria-label={ariaLabel}
      style={portal ? portalStyle : undefined}
    >
      {options.map((option) => {
        const isSelected = option.value === value;
        const enabledIndex = enabledOptions.findIndex((candidate) => candidate.value === option.value);
        return (
          <button
            type="button"
            key={option.value}
            role="option"
            aria-selected={isSelected}
            disabled={option.disabled}
            className={`custom-select-option${isSelected ? " selected" : ""}${enabledIndex === activeIndex ? " active" : ""}`}
            onMouseEnter={() => {
              if (!option.disabled) setActiveIndex(enabledIndex);
            }}
            onClick={() => choose(option)}
          >
            <span>{option.label}</span>
            {isSelected && <Check size={16} aria-hidden="true" />}
          </button>
        );
      })}
    </div>
  ) : null;

  return (
    <div ref={rootRef} className={`custom-select${open ? " open" : ""}`}>
      <button
        ref={triggerRef}
        type="button"
        className="custom-select-trigger"
        title={selected?.label}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        disabled={disabled}
        onClick={() => open ? setOpen(false) : openMenu()}
        onKeyDown={onKeyDown}
      >
        <span className={selected ? "" : "custom-select-placeholder"}>
          {selected?.label ?? placeholder}
        </span>
        <ChevronDown size={17} aria-hidden="true" />
      </button>
      {portal && typeof document !== "undefined" ? createPortal(menu, document.body) : menu}
    </div>
  );
}
