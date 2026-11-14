"use client";

import { Badge } from "../components/ui/badge";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "../components/ui/card";
import { GROUP_FOOTER, GROUPS, SCENES, STATUS, scenarioCount, type Scene } from "./im-support-settings-scenes";

export function AssistantSceneCatalog({ group }: { group: Scene["group"] }) {
  const currentGroup = GROUPS.find((item) => item.id === group)!;
  const catalogScenes = SCENES.filter((scene) => scene.group === group);
  return <Card>
            <CardHeader>
              <div className="im-assistant-card-head">
                <div><CardTitle>{currentGroup.title}</CardTitle><CardDescription>{currentGroup.description}</CardDescription></div>
                <Badge variant="outline">{scenarioCount(catalogScenes)} 种场景</Badge>
              </div>
            </CardHeader>
            <CardContent className="im-assistant-catalog">
              {catalogScenes.map((scene) => <article key={scene.key}>
                <div className="im-assistant-scene-head"><h3>{scene.label}</h3><Badge variant={STATUS[scene.status].variant}>{STATUS[scene.status].label}</Badge></div>
                {scene.buckets ? <ul className="im-assistant-buckets" aria-label="到期提醒档位">{scene.buckets.map((bucket) => <li key={bucket}>{bucket}</li>)}</ul> : null}
                <dl className="im-assistant-facts">
                  <div><dt>触发</dt><dd>{scene.when}</dd></div>
                  <div><dt>发送身份</dt><dd>{scene.sender}</dd></div>
                </dl>
                <small>{scene.note}</small>
              </article>)}
            </CardContent>
            <CardFooter><p className="im-assistant-help">{GROUP_FOOTER[group]}</p></CardFooter>
  </Card>;
}
