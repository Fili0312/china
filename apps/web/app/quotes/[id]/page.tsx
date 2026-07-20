import { QuoteView } from "./quote-view";

export default async function QuotePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <QuoteView id={id} />;
}
