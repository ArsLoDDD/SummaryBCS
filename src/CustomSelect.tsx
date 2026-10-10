import { useEffect, useId, useMemo, useRef, useState } from "react";
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
}

export default function CustomSelect<T extends string>({
  ariaLabel,
  value,
  options,
  onChange,
  placeholder = "Оберіть",
  disabled = false,
}: Props<T>) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const rootRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const enabledOptions = useMemo(() => options.filter((option) => !option.disabled), [options]);
  const selected = options.find((option) => option.value === value);

  useEffect(() => {
    function closeOutside(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", closeOutside);
    return () => document.removeEventListener("mousedown", closeOutside);
  }, []);

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

  return (
    <div ref={rootRef} className={`custom-select${open ? " open" : ""}`}>
      <button
        type="button"
        className="custom-select-trigger"
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
      {open && (
        <div id={listId} className="custom-select-menu" role="listbox" aria-label={ariaLabel}>
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
      )}
    </div>
  );
}
