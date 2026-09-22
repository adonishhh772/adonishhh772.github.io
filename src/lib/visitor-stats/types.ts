export interface PublicStats {
  totalUniqueVisitors: number;
  gatherClicks: number;
}

export interface VisitResult extends PublicStats {
  visitorNumber: number;
  isNew: boolean;
}
