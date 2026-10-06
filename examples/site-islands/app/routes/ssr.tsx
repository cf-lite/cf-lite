import Counter from "../islands/Counter.island";
import Echo from "../islands/Echo.island";

// SSR page without Suspense: under the strict nonce CSP the island runtime <script> must carry the per-request nonce.
export const render = "ssr";
export const loader = () => ({ msg: 'nonce "<page>"' });

export default function Ssr({ data }: { data: { msg: string } }) {
  return <main><h1>Ssr</h1><Counter start={3} /><Echo msg={data.msg} items={["x"]} /></main>;
}
