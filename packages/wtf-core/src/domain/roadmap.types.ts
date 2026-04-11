// Roadmap-level domain types: milestone planning, slice entries, boundary maps.

export type RiskLevel = "low" | "medium" | "high";

export interface RoadmapSliceEntry {
  id: string; // e.g. "S01"
  title: string; // e.g. "Types + File I/O + Git Operations"
  risk: RiskLevel;
  depends: string[]; // e.g. ["S01", "S02"]
  done: boolean;
  demo: string; // the "After this:" sentence
}

export interface BoundaryMapEntry {
  fromSlice: string; // e.g. "S01"
  toSlice: string; // e.g. "S02" or "terminal"
  produces: string; // raw text block of what this slice produces
  consumes: string; // raw text block of what it consumes (or "nothing")
}

export interface Roadmap {
  title: string; // e.g. "M001: WTF Extension — Hierarchical Planning with Auto Mode"
  vision: string;
  successCriteria: string[];
  slices: RoadmapSliceEntry[];
  boundaryMap: BoundaryMapEntry[];
}
