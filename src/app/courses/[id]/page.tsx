import { CourseScreen } from "@/components/screens/CourseScreen";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <CourseScreen courseId={id} />;
}
