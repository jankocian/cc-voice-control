import { Slider as BaseSlider } from "@base-ui-components/react/slider";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

// shadcn-style Slider built on Base UI's Slider primitive. Tokenized: a violet
// filled indicator on a soft track with a white draggable thumb. Used for the
// inline audio scrubber inside agent bubbles.
type SliderProps = ComponentProps<typeof BaseSlider.Root> & {
  className?: string;
  trackClassName?: string;
  indicatorClassName?: string;
  thumbClassName?: string;
};

export function Slider({ className, trackClassName, indicatorClassName, thumbClassName, ...props }: SliderProps) {
  return (
    <BaseSlider.Root className={cn("relative w-full", className)} {...props}>
      <BaseSlider.Control className="flex w-full items-center py-1.5 touch-none select-none">
        <BaseSlider.Track
          className={cn("relative h-1.5 w-full grow overflow-hidden rounded-full bg-violet/25", trackClassName)}
        >
          <BaseSlider.Indicator className={cn("rounded-full bg-violet", indicatorClassName)} />
          <BaseSlider.Thumb
            className={cn(
              "size-3.5 rounded-full bg-surface shadow-soft ring-2 ring-violet outline-none transition-transform focus-visible:ring-2 focus-visible:ring-violet/70",
              thumbClassName
            )}
          />
        </BaseSlider.Track>
      </BaseSlider.Control>
    </BaseSlider.Root>
  );
}
