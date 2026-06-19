import { Tabs as BaseTabs } from "@base-ui/react/tabs";
import * as React from "react";
import { cn } from "../../lib/utils";

export const Tabs = BaseTabs.Root;

export const TabsList = React.forwardRef<
  React.ElementRef<typeof BaseTabs.List>,
  React.ComponentPropsWithoutRef<typeof BaseTabs.List>
>(({ className, ...props }, ref) => (
  <BaseTabs.List ref={ref} className={cn("grid grid-cols-2 gap-2", className)} {...props} />
));

TabsList.displayName = "TabsList";

export const TabsTrigger = React.forwardRef<
  React.ElementRef<typeof BaseTabs.Tab>,
  React.ComponentPropsWithoutRef<typeof BaseTabs.Tab>
>(({ className, ...props }, ref) => (
  <BaseTabs.Tab
    ref={ref}
    className={cn(
      "rounded-full border border-amber-50/20 bg-black/35 px-3 py-2 text-xs font-black uppercase tracking-wide text-amber-50/65 transition data-[active]:bg-amber-50 data-[active]:text-stone-950",
      className,
    )}
    {...props}
  />
));

TabsTrigger.displayName = "TabsTrigger";
