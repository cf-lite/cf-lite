export default function Err({ data }: { data: { error: { message: string; digest: string } } }) {
  return <main><h1 data-testid="err">Something broke</h1><p data-testid="digest">{data.error.digest ? "digest" : "no-digest"}</p><p data-testid="msg">{data.error.message}</p></main>;
}
