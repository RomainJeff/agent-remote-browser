import { MonitorIcon } from 'lucide-react';

export function Brand() {
  return (
    <div className="flex items-center gap-3">
      <span className="flex size-9 flex-none items-center justify-center rounded-xl bg-primary text-primary-foreground"><MonitorIcon className="size-[18px]" /></span>
      <div><b className="block text-[15px] font-extrabold">Agent Remote Browser</b><span className="text-xs text-muted-foreground">Admin console</span></div>
    </div>
  );
}
