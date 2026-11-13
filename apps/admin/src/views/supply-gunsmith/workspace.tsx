import { useMemo } from "react";
import type { AdminGunsmithAlias, AdminGunsmithClassification, AdminGunsmithCode, AdminGunsmithFirearm } from "../../api";
import type { FirearmGroup } from "./model";
import { FirearmPicker } from "./firearm-picker";
import { SchemePanel } from "./scheme-panel";

export function GunsmithWorkspace({
  groups,
  classifications,
  firearm,
  codes,
  aliases,
  totalFirearms,
  allCodes = [],
  firearmQuery,
  codeQuery,
  mode,
  status,
  busy,
  editing,
  onFirearmQuery,
  onCodeQuery,
  onMode,
  onStatus,
  onSelect,
  onNew,
  onEdit,
  onStatusChange,
  onAlias,
  onEditAlias,
  onEditFirearm,
  onCatalog,
  onRefresh,
}: {
  groups: FirearmGroup[];
  classifications: AdminGunsmithClassification[];
  firearm: AdminGunsmithFirearm | null;
  codes: AdminGunsmithCode[];
  aliases: AdminGunsmithAlias[];
  totalFirearms: number;
  allCodes?: AdminGunsmithCode[];
  firearmQuery: string;
  codeQuery: string;
  mode: string;
  status: string;
  busy: boolean;
  editing: boolean;
  onFirearmQuery: (v: string) => void;
  onCodeQuery: (v: string) => void;
  onMode: (v: string) => void;
  onStatus: (v: string) => void;
  onSelect: (id: string) => void;
  onNew: () => void;
  onEdit: (code: AdminGunsmithCode) => void;
  onStatusChange: (code: AdminGunsmithCode) => void;
  onAlias: () => void;
  onEditAlias: (alias: AdminGunsmithAlias) => void;
  onEditFirearm: () => void;
  onCatalog: () => void;
  onRefresh: () => void;
}) {
  const codeCountMap = useMemo(() => {
    const map = new Map<string, number>();
    for (const c of allCodes) {
      map.set(c.firearmId, (map.get(c.firearmId) ?? 0) + 1);
    }
    return map;
  }, [allCodes]);

  return (
    <div className="grid min-w-0 items-start gap-5 xl:grid-cols-[21rem_minmax(0,1fr)] 2xl:grid-cols-[23rem_minmax(0,1fr)]">
      <FirearmPicker
        groups={groups}
        classifications={classifications}
        firearm={firearm}
        totalFirearms={totalFirearms}
        firearmQuery={firearmQuery}
        codeCountMap={codeCountMap}
        busy={busy}
        editing={editing}
        onFirearmQuery={onFirearmQuery}
        onSelect={onSelect}
        onCatalog={onCatalog}
      />
      <SchemePanel
        groups={groups}
        classifications={classifications}
        firearm={firearm}
        codes={codes}
        aliases={aliases}
        codeCountMap={codeCountMap}
        codeQuery={codeQuery}
        mode={mode}
        status={status}
        busy={busy}
        editing={editing}
        onCodeQuery={onCodeQuery}
        onMode={onMode}
        onStatus={onStatus}
        onSelect={onSelect}
        onNew={onNew}
        onEdit={onEdit}
        onStatusChange={onStatusChange}
        onAlias={onAlias}
        onEditAlias={onEditAlias}
        onEditFirearm={onEditFirearm}
        onCatalog={onCatalog}
        onRefresh={onRefresh}
      />
    </div>
  );
}
