export function AccountCardSkeleton({ viewMode = "grid" }: { viewMode?: "grid" | "list" }) {
  if (viewMode === "list") {
    return (
      <div className="account-skeleton account-skeleton--list" aria-hidden="true">
        <div className="account-skeleton-media" />
        <div className="account-skeleton-content">
          <div className="account-skeleton-title" />
          <div className="account-skeleton-meta" />
          <div className="account-skeleton-matrix" />
        </div>
        <div className="account-skeleton-rail">
          <div className="account-skeleton-price" />
          <div className="account-skeleton-button" />
        </div>
      </div>
    );
  }

  return (
    <div className="account-skeleton account-skeleton--grid" aria-hidden="true">
      <div className="account-skeleton-media" />
      <div className="account-skeleton-body">
        <div className="account-skeleton-title" />
        <div className="account-skeleton-meta" />
        <div className="account-skeleton-subattrs" />
        <div className="account-skeleton-skins" />
        <div className="account-skeleton-resources" />
        <div className="account-skeleton-breakdown" />
      </div>
    </div>
  );
}
