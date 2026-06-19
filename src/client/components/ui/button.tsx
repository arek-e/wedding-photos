import { Button as BaseButton } from "@base-ui/react/button";
import * as React from "react";
import { cn } from "../../lib/utils";

type ButtonVariant = "default" | "ghost" | "camera" | "shutter" | "tab";

type ButtonProps = React.ComponentPropsWithoutRef<typeof BaseButton> & {
  variant?: ButtonVariant;
};

const variants: Record<ButtonVariant, string> = {
  default:
    "rounded-full bg-stone-950 px-5 py-3 font-black text-amber-50 shadow-xl transition hover:bg-stone-800 disabled:cursor-not-allowed disabled:opacity-50",
  ghost:
    "rounded-full bg-transparent px-3 py-2 font-black text-amber-50 transition hover:bg-white/10",
  camera:
    "rounded-full border border-amber-50/25 bg-black/35 px-3 py-2 text-xs font-black uppercase tracking-[0.12em] text-amber-50/70 transition hover:bg-amber-50 hover:text-stone-950 data-[active=true]:bg-amber-50 data-[active=true]:text-stone-950",
  shutter:
    "grid size-24 place-items-center rounded-full border-[6px] border-amber-50/90 bg-amber-50/15 shadow-[0_0_0_10px_rgba(0,0,0,0.28),0_20px_50px_rgba(0,0,0,0.5)] transition disabled:cursor-not-allowed disabled:opacity-45 md:size-20",
  tab: "rounded-full px-3 py-2 text-xs font-black uppercase tracking-wide transition",
};

export const Button = React.forwardRef<React.ElementRef<typeof BaseButton>, ButtonProps>(
  ({ className, variant = "default", ...props }, ref) => (
    <BaseButton ref={ref} className={cn(variants[variant], className)} {...props} />
  ),
);

Button.displayName = "Button";
