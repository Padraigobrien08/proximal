import { SessionScreen } from "@/components/screens/SessionScreen";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <SessionScreen sessionId={id} />;
}
