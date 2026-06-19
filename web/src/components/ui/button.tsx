import { cva, type VariantProps } from "class-variance-authority";
import type { ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

// shadcn-style Button, retuned for the warm voice-assistant system. Every variant
// and size resolves to design-system tokens (coral / violet / surface / ink),
// never raw values. Circular icon controls use the `icon` / `fab` sizes.
const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap font-medium outline-none transition-[transform,background-color,box-shadow,color] duration-200 ease-soft select-none active:scale-[0.97] focus-visible:ring-2 focus-visible:ring-ring/55 disabled:pointer-events-none disabled:opacity-45 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        // Filled coral — the primary mic / call-to-action.
        coral: "bg-coral text-white shadow-mic hover:bg-coral/90",
        // White surface chip with soft lift — app-bar icon buttons, pills.
        surface: "bg-surface text-ink shadow-soft hover:bg-canvas-deep",
        // Soft coral chip (peach) — secondary emphasis on cream.
        soft: "bg-coral-soft text-coral-ink hover:bg-coral-soft/80",
        // Soft violet chip — agent-side accents.
        violet: "bg-violet-soft text-violet-ink hover:bg-violet-soft/80",
        // Destructive red — the Stop control.
        danger: "bg-danger text-white shadow-mic hover:bg-danger/90",
        // Bare ghost — low-emphasis taps inside bubbles / rows.
        ghost: "bg-transparent text-ink-soft hover:bg-canvas-deep hover:text-ink",
        // Transparent text link.
        link: "bg-transparent text-coral underline-offset-4 hover:underline"
      },
      size: {
        sm: "h-9 rounded-control px-3 text-sm",
        md: "h-11 rounded-control px-5 text-sm",
        lg: "h-13 rounded-control px-6 text-base",
        pill: "h-10 rounded-full px-4 text-sm",
        // Circular icon buttons (app bar / waveform).
        icon: "size-11 rounded-full [&_svg]:size-5",
        iconSm: "size-9 rounded-full [&_svg]:size-[18px]",
        // Big circular floating action (the mic).
        fab: "size-[72px] rounded-full [&_svg]:size-7"
      }
    },
    defaultVariants: {
      variant: "surface",
      size: "md"
    }
  }
);

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof buttonVariants>;

export function Button({ className, variant, size, type = "button", ...props }: ButtonProps) {
  return <button type={type} className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}

export { buttonVariants };
