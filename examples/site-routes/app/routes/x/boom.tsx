export const render = "ssr";
export async function loader(): Promise<never> { throw new Error("secret stack detail"); }
export default function Boom() { return <h1>unreachable</h1>; }
