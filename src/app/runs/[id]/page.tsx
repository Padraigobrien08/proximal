import { RunSummaryScreen } from "@/components/screens/RunSummaryScreen";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <RunSummaryScreen runId={id} />;
}
