import { useState } from "react";

export const client = "interaction";
export default function Menu() {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button data-testid="menu-btn" aria-expanded={open} onClick={() => setOpen(!open)}>menu</button>
      {open ? <ul data-testid="menu-list"><li>one</li><li>two</li></ul> : null}
    </div>
  );
}
