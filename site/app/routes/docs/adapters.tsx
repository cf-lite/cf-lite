import doc from "../../../.content/adapters.json";
import { DocPage, docHead } from "../../components/DocPage";

export const render = "static";
export const head = docHead(doc);

export default function Page() {
  return <DocPage doc={doc} />;
}
