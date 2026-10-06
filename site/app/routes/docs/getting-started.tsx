import doc from "../../../.content/getting-started.json";
import { DocPage, docHead } from "../../components/DocPage";

export const render = "static";
export const head = docHead(doc);

export default function Page() {
  return <DocPage doc={doc} />;
}
