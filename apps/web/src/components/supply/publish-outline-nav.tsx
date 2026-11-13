"use client";

import { Check } from "lucide-react";
import { groupMeta } from "./publish-form-helpers";
import type { PublishGroupId } from "./publish-form-types";

export function PublishOutlineNav({
  activeGroup,
  errorGroups,
  groupDone,
}: {
  activeGroup: PublishGroupId;
  errorGroups: Set<PublishGroupId>;
  groupDone: Record<PublishGroupId, boolean>;
}) {
  return (
    <aside id="publish-outline" className="publish-outline publish-timeline-rail" aria-label="步骤导航">
      <nav className="publish-outline-groups publish-timeline-track">
        {(Object.keys(groupMeta) as PublishGroupId[]).map((id) => {
          const isActive = activeGroup === id;
          const isError = errorGroups.has(id);
          const isDone = !isError && groupDone[id];
          return (
            <a
              key={id}
              href={`#publish-group-${id}`}
              className={`publish-timeline-node${isActive ? " is-active" : ""}${isError ? " is-error" : ""}${isDone ? " is-done" : ""}`}
              aria-current={isActive ? "step" : undefined}
              onClick={(e) => {
                e.preventDefault();
                const target = document.getElementById(`publish-group-${id}`);
                if (target) {
                  const headerOffset = 90;
                  const targetTop = target.getBoundingClientRect().top + window.scrollY - headerOffset;
                  window.scrollTo({ top: Math.max(0, targetTop), behavior: "smooth" });
                }
              }}
            >
              <span className="publish-timeline-marker">
                <span className="publish-timeline-dot">{isDone && !isActive ? <Check size={9} strokeWidth={3} aria-hidden="true" /> : null}</span>
                <span className="publish-timeline-line" />
              </span>
              <span className="publish-timeline-copy">
                <span className="publish-timeline-title">{groupMeta[id].title}</span>
              </span>
              {isError ? <span className="publish-timeline-badge-err" title="有待完善项" /> : null}
            </a>
          );
        })}
      </nav>
    </aside>
  );
}
