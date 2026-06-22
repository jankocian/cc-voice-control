import { Menu } from "@base-ui-components/react/menu";
import { Settings } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import type { ThemeMode } from "@/hooks/useTheme";
import type { SpeakMode } from "@/lib/protocol";
import { cn } from "@/lib/utils";

type Option<T extends string> = { value: T; label: string; aria: string };

// Autoplay = whether a reply plays by itself. Replies are ALWAYS synthesized; "Off" just means tap to hear
// (the audio is ready either way) — it never silences synthesis. "Everything" also auto-reads each step.
const SPEAK_OPTIONS: Option<SpeakMode>[] = [
  { value: "off", label: "Off", aria: "Don't play replies automatically — tap a reply to hear it" },
  { value: "final", label: "Final reply", aria: "Auto-play the final reply" },
  { value: "all", label: "Everything", aria: "Auto-play the final reply and every step" }
];

const THEME_OPTIONS: Option<ThemeMode>[] = [
  { value: "system", label: "System", aria: "Follow the system theme" },
  { value: "dark", label: "Dark", aria: "Dark theme" },
  { value: "light", label: "Light", aria: "Light theme" }
];

// Auto-follow: when ON, a fresh reply on a background thread auto-switches to it (and plays on land).
const AUTO_FOLLOW_OPTIONS: Option<"off" | "on">[] = [
  { value: "off", label: "Off", aria: "Stay on the current thread when other threads reply" },
  { value: "on", label: "On", aria: "Auto-switch to new messages across threads" }
];

// Auto-respond (hands-free): when ON, the mic opens automatically after a reply finishes playing.
const AUTO_RESPOND_OPTIONS: Option<"off" | "on">[] = [
  { value: "off", label: "Off", aria: "Don't open the mic automatically after a reply" },
  { value: "on", label: "On", aria: "Open the mic automatically after a reply finishes playing" }
];

// A pill-shaped segmented control (one Base UI radio group). Picking a segment does NOT close the menu, so
// both settings can be changed before dismissing (tap outside to close).
function Segmented<T extends string>({
  value,
  onValueChange,
  options,
  disabled = false
}: {
  value: T;
  onValueChange: (value: T) => void;
  options: Option<T>[];
  disabled?: boolean;
}) {
  return (
    <Menu.RadioGroup
      value={value}
      onValueChange={(next) => !disabled && onValueChange(next as T)}
      aria-disabled={disabled}
      className={cn(
        "inline-flex w-fit items-center gap-0.5 self-start rounded-full bg-canvas-deep p-0.5",
        disabled && "pointer-events-none opacity-40"
      )}
    >
      {options.map((option) => (
        <Menu.RadioItem
          key={option.value}
          value={option.value}
          aria-label={option.aria}
          closeOnClick={false}
          className={(state) =>
            cn(
              "cursor-default select-none rounded-full px-3 py-1.5 text-xs font-medium outline-none transition-colors",
              state.checked ? "bg-surface text-ink shadow-soft" : "text-ink-soft hover:text-ink"
            )
          }
        >
          {option.label}
        </Menu.RadioItem>
      ))}
    </Menu.RadioGroup>
  );
}

// One setting: a label with the choices as a segmented control beneath it (the control is only as wide as
// its options, not stretched).
function Field<T extends string>(props: {
  label: string;
  value: T;
  onValueChange: (value: T) => void;
  options: Option<T>[];
  disabled?: boolean;
  hint?: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className={cn("text-xs font-semibold text-ink-soft", props.disabled && "opacity-50")}>{props.label}</span>
      <Segmented
        value={props.value}
        onValueChange={props.onValueChange}
        options={props.options}
        disabled={props.disabled}
      />
      {props.hint && <span className="text-[11px] leading-tight text-ink-faint">{props.hint}</span>}
    </div>
  );
}

// Nav-bar settings menu, built on Base UI's Menu (the project's primitive — see ui/slider.tsx). One field
// per setting, stacked. Holds autoplay + theme today; more settings get their own field here instead of
// crowding the bar.
export function SettingsMenu({
  speakMode,
  onSpeakModeChange,
  autoFollow,
  onAutoFollowChange,
  autoRespond,
  onAutoRespondChange,
  autoRespondAvailable,
  theme,
  onThemeChange
}: {
  speakMode: SpeakMode;
  onSpeakModeChange: (mode: SpeakMode) => void;
  autoFollow: boolean;
  onAutoFollowChange: (on: boolean) => void;
  autoRespond: boolean;
  onAutoRespondChange: (on: boolean) => void;
  // Auto-respond only makes sense with autoplay on + auto-follow on; otherwise the field is shown disabled.
  autoRespondAvailable: boolean;
  theme: ThemeMode;
  onThemeChange: (theme: ThemeMode) => void;
}) {
  return (
    <Menu.Root>
      <Menu.Trigger className={buttonVariants({ variant: "surface", size: "iconSm" })} aria-label="Settings">
        <Settings />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner className="z-50 outline-none" sideOffset={8} align="end">
          <Menu.Popup className="flex flex-col gap-3 rounded-bubble border border-hairline bg-surface p-3 text-ink shadow-lift outline-none">
            <Field label="Autoplay" value={speakMode} onValueChange={onSpeakModeChange} options={SPEAK_OPTIONS} />
            <Field
              label="Auto-follow"
              value={autoFollow ? "on" : "off"}
              onValueChange={(v) => onAutoFollowChange(v === "on")}
              options={AUTO_FOLLOW_OPTIONS}
            />
            <Field
              label="Auto-respond"
              value={autoRespond ? "on" : "off"}
              onValueChange={(v) => onAutoRespondChange(v === "on")}
              options={AUTO_RESPOND_OPTIONS}
              disabled={!autoRespondAvailable}
              hint={
                autoRespondAvailable
                  ? "Opens the mic right after a reply — listen, speak, hit stop."
                  : "Turn on Autoplay and Auto-follow to use this."
              }
            />
            <Field label="Theme" value={theme} onValueChange={onThemeChange} options={THEME_OPTIONS} />
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
