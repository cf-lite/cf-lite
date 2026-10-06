import Counter from "../components/Counter";
export const render = "ssr";
export const loader = async () => ({ start: 5 });
export default function Live({ data }: { data: { start: number } }) { return <main><h1>Live</h1><Counter start={data.start} /></main>; }
