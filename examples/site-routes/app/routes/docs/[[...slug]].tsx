export const render = "ssr";
export default function Docs({ params }: { params: Record<string, string> }) {
  return <main><h1 data-testid="docs">docs:[{params["*"]}]</h1></main>;
}
