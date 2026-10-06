export interface ButtonProps { label: string; variant?: "solid" | "ghost"; disabled?: boolean }

export default function Button({ label, variant = "solid", disabled = false }: ButtonProps) {
  return <button type="button" className={variant === "ghost" ? "btn btn--ghost" : "btn"} disabled={disabled}>{label}</button>;
}
