import * as React from "react";
import * as SelectPrimitive from "@radix-ui/react-select";
import { Check, ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "@/lib/utils";

const Select = SelectPrimitive.Root;
const SelectGroup = SelectPrimitive.Group;
const SelectValue = SelectPrimitive.Value;

export interface SelectTriggerProps
  extends React.ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger> {
  size?: "default" | "sm" | "xs" | "lg";
  variant?: "default" | "ghost";
  hideChevron?: boolean;
}

const SelectTrigger = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Trigger>,
  SelectTriggerProps
>(
  (
    {
      className,
      children,
      size = "default",
      variant = "default",
      hideChevron = false,
      ...props
    },
    ref
  ) => {
    return (
      <SelectPrimitive.Trigger
        ref={ref}
        data-slot="select-trigger"
        className={cn(
          "group/select-trigger inline-flex w-full items-center justify-between text-left font-normal select-none transition-all outline-none disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
          // Variants
          variant === "default" && [
            "rounded-lg border border-input bg-background dark:bg-input/30 text-foreground",
            "hover:border-foreground/30 hover:bg-muted/10",
            "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
            "data-[state=open]:border-ring data-[state=open]:ring-3 data-[state=open]:ring-ring/50",
            "aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20"
          ],
          variant === "ghost" && [
            "border-0 bg-transparent text-foreground hover:bg-muted/40",
            "focus-visible:ring-2 focus-visible:ring-ring/40 data-[state=open]:bg-muted/40"
          ],
          // Sizes
          size === "default" && "h-8 px-2.5 py-1 text-xs md:text-sm gap-1.5",
          size === "sm" && "h-7 px-2 py-0.5 text-xs gap-1",
          size === "xs" && "h-6 px-1.5 py-0 text-xs gap-0.5",
          size === "lg" && "h-9 px-3 py-1.5 text-sm gap-2",
          className
        )}
        {...props}
      >
        <span className="truncate flex-1">{children}</span>
        {!hideChevron && (
          <SelectPrimitive.Icon asChild>
            <ChevronDown className="size-3.5 shrink-0 text-muted-foreground transition-transform duration-200 group-data-[state=open]/select-trigger:rotate-180" />
          </SelectPrimitive.Icon>
        )}
      </SelectPrimitive.Trigger>
    );
  }
);
SelectTrigger.displayName = SelectPrimitive.Trigger.displayName;

const SelectScrollUpButton = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.ScrollUpButton>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.ScrollUpButton>
>(({ className, ...props }, ref) => (
  <SelectPrimitive.ScrollUpButton
    ref={ref}
    className={cn(
      "flex cursor-default items-center justify-center py-1 text-muted-foreground",
      className
    )}
    {...props}
  >
    <ChevronUp className="size-3.5" />
  </SelectPrimitive.ScrollUpButton>
));
SelectScrollUpButton.displayName = SelectPrimitive.ScrollUpButton.displayName;

const SelectScrollDownButton = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.ScrollDownButton>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.ScrollDownButton>
>(({ className, ...props }, ref) => (
  <SelectPrimitive.ScrollDownButton
    ref={ref}
    className={cn(
      "flex cursor-default items-center justify-center py-1 text-muted-foreground",
      className
    )}
    {...props}
  >
    <ChevronDown className="size-3.5" />
  </SelectPrimitive.ScrollDownButton>
));
SelectScrollDownButton.displayName =
  SelectPrimitive.ScrollDownButton.displayName;

export interface SelectContentProps
  extends React.ComponentPropsWithoutRef<typeof SelectPrimitive.Content> {
  viewportClassName?: string;
}

const SelectContent = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Content>,
  SelectContentProps
>(
  (
    {
      className,
      children,
      position = "popper",
      sideOffset = 4,
      viewportClassName,
      ...props
    },
    ref
  ) => (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        ref={ref}
        data-slot="select-content"
        className={cn(
          // Kontur UI popup container: небольшое скругление/rounded-xl, мягкая тень, 1px граница
          "relative z-[70] max-h-72 min-w-[8rem] overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-lg shadow-black/10 transition-all duration-150",
          "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
          position === "popper" && [
            "data-[side=bottom]:translate-y-1 data-[side=top]:-translate-y-1",
            "data-[side=bottom]:slide-in-from-top-1 data-[side=top]:slide-in-from-bottom-1"
          ],
          className
        )}
        position={position}
        sideOffset={sideOffset}
        {...props}
      >
        <SelectScrollUpButton />
        {/* Контейнер: небольшой padding (p-1) и отсутствие расстояния между элементами (space-y-0) */}
        <SelectPrimitive.Viewport
          className={cn(
            "p-1 space-y-0",
            position === "popper" &&
              "w-full min-w-[var(--radix-select-trigger-width)]",
            viewportClassName
          )}
        >
          {children}
        </SelectPrimitive.Viewport>
        <SelectScrollDownButton />
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  )
);
SelectContent.displayName = SelectPrimitive.Content.displayName;

const SelectLabel = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Label>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Label>
>(({ className, ...props }, ref) => (
  <SelectPrimitive.Label
    ref={ref}
    className={cn(
      "px-2.5 py-1 text-[11px] font-semibold text-muted-foreground uppercase tracking-wider",
      className
    )}
    {...props}
  />
));
SelectLabel.displayName = SelectPrimitive.Label.displayName;

const SelectItem = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Item>
>(({ className, children, ...props }, ref) => (
  <SelectPrimitive.Item
    ref={ref}
    data-slot="select-item"
    className={cn(
      // Скругление элементов: rounded-md, отсутствие отступов между элементами: my-0
      "relative flex w-full cursor-pointer select-none items-center justify-between rounded-md px-2.5 py-1.5 text-xs outline-none transition-colors my-0",
      "hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground",
      "data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground",
      "data-[state=checked]:bg-accent/60 data-[state=checked]:font-medium data-[state=checked]:text-foreground",
      "data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
      className
    )}
    {...props}
  >
    <SelectPrimitive.ItemText className="truncate">
      {children}
    </SelectPrimitive.ItemText>
    <SelectPrimitive.ItemIndicator className="ml-2 flex items-center justify-center shrink-0">
      <Check className="size-3.5 stroke-[2.5] text-primary" />
    </SelectPrimitive.ItemIndicator>
  </SelectPrimitive.Item>
));
SelectItem.displayName = SelectPrimitive.Item.displayName;

const SelectSeparator = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Separator>
>(({ className, ...props }, ref) => (
  <SelectPrimitive.Separator
    ref={ref}
    className={cn("-mx-1 my-1 h-px bg-border", className)}
    {...props}
  />
));
SelectSeparator.displayName = SelectPrimitive.Separator.displayName;

// High-level wrapper for simple dropdowns
export interface SelectOption {
  value: string;
  label: React.ReactNode;
  disabled?: boolean;
}

export interface SelectFieldProps {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  triggerClassName?: string;
  contentClassName?: string;
  id?: string;
  "data-testid"?: string;
  "aria-label"?: string;
  size?: "default" | "sm" | "xs" | "lg";
  variant?: "default" | "ghost";
  hideChevron?: boolean;
}

export const SelectField: React.FC<SelectFieldProps> = ({
  value,
  defaultValue,
  onValueChange,
  options,
  placeholder,
  disabled,
  triggerClassName,
  contentClassName,
  id,
  "data-testid": dataTestId,
  "aria-label": ariaLabel,
  size = "default",
  variant = "default",
  hideChevron = false,
}) => {
  return (
    <Select
      value={value}
      defaultValue={defaultValue}
      onValueChange={onValueChange}
      disabled={disabled}
    >
      <SelectTrigger
        id={id}
        data-testid={dataTestId}
        aria-label={ariaLabel}
        size={size}
        variant={variant}
        hideChevron={hideChevron}
        className={triggerClassName}
      >
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent className={contentClassName}>
        {options.map((opt) => (
          <SelectItem
            key={opt.value}
            value={opt.value}
            disabled={opt.disabled}
          >
            {opt.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
};

export {
  Select,
  SelectGroup,
  SelectValue,
  SelectTrigger,
  SelectContent,
  SelectLabel,
  SelectItem,
  SelectSeparator,
  SelectScrollUpButton,
  SelectScrollDownButton,
};
