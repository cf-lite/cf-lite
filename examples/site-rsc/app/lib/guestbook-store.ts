// Server-only state for the P3 form-action fixture (per isolate; fine for the e2e, a real app uses D1/KV).
export const guestbook: { names: string[]; lastUrl: string } = { names: [], lastUrl: "" };
