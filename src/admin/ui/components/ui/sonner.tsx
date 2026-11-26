import { Toaster as Sonner, type ToasterProps } from "sonner"

// shadcn's Toaster without next-themes (the admin is light only), styled like the previous dark toasts.
const Toaster = (props: ToasterProps) => (
  <Sonner
    theme="light"
    position="bottom-right"
    toastOptions={{ classNames: { toast: "bg-foreground! text-white! border-0! rounded-lg! text-sm!", error: "before:font-semibold before:content-['Error:']" } }}
    {...props}
  />
)

export { Toaster }
