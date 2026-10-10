"use client";

import { useApiResource } from "../useApiResource";
import type { ProviderInfo } from "../ProviderBadge";
import { CourseList, type CourseSummaryView } from "../workspace";

export function CoursesScreen() {
  const { data, error, reload } = useApiResource<{ provider: ProviderInfo; courses: CourseSummaryView[] }>("/api/courses");
  if (error && !data) {
    return (
      <div role="alert" className="rounded-xl border border-red-ink/20 bg-red-soft p-5 text-red-ink">
        <p className="font-medium">We couldn&apos;t load your courses.</p>
        <button type="button" onClick={reload} className="mt-2 text-sm underline">
          Retry
        </button>
      </div>
    );
  }
  if (!data) return <div aria-busy="true" className="h-[160px] rounded-[10px] border border-line bg-card" />;
  return <CourseList courses={data.courses} headingLevel="h1" />;
}
