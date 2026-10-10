import { TopicScreen } from "@/components/screens/TopicScreen";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <TopicScreen topicId={id} />;
}
