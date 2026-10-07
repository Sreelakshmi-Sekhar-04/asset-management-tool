import type { Location, RowOutcome } from '@prisma/client';
import type { Db } from '@/lib/db';
import type { Actor } from '../actor';
import { createLocation } from '../services/locations';

export interface ImportContext { mode: 'CREATE_ONLY' | 'CREATE_OR_UPDATE'; createMissing: boolean }
export interface RowResult<P> { rowNumber: number; data: Record<string, string>; outcome: RowOutcome; messages: string[]; matchedId?: string; plan?: P }
export interface ValidationResult<P> { rows: RowResult<P>[]; locationsToCreate: string[]; departmentsToCreate: string[] }

type Resolved = { kind: 'found'; id: string; path: string } | { kind: 'create'; path: string } | { kind: 'unknown' } | { kind: 'ambiguous' };

/** Resolves "Region/Branch" paths (case-insensitive), with a unique trailing-name fallback; collects nodes to create. */
export class LocationResolver {
  private all: Location[] = [];
  private byPath = new Map<string, Location>();
  private pending = new Map<string, string>();
  constructor(private db: Db, private createMissing: boolean) {}
  async load() {
    this.all = await this.db.location.findMany();
    this.byPath = new Map(this.all.map((l) => [l.namePath.toLowerCase(), l]));
  }
  /** The path names a location that exists but is inactive (so it must not be offered for creation). */
  isInactive(raw: string) {
    const key = LocationResolver.norm(raw).toLowerCase();
    return this.all.some((l) => !l.active && (l.namePath.toLowerCase() === key || l.namePath.toLowerCase().endsWith(' / ' + key)));
  }
  static norm(p: string) {
    return p.split(/[/\\>]/).map((s) => s.trim()).filter(Boolean).join(' / ');
  }
  resolve(raw: string): Resolved {
    const path = LocationResolver.norm(raw);
    const key = path.toLowerCase();
    const exact = this.byPath.get(key);
    if (exact) return exact.active ? { kind: 'found', id: exact.id, path: exact.namePath } : { kind: 'unknown' };
    const tail = this.all.filter((l) => l.active && l.namePath.toLowerCase().endsWith(' / ' + key));
    if (tail.length === 1) return { kind: 'found', id: tail[0].id, path: tail[0].namePath };
    if (tail.length > 1) return { kind: 'ambiguous' };
    if (!this.createMissing) return { kind: 'unknown' };
    this.pending.set(key, path);
    return { kind: 'create', path };
  }
  toCreate() {
    // Include intermediate nodes that are also missing, shallowest first.
    const out = new Map<string, string>();
    for (const p of this.pending.values()) {
      const parts = p.split(' / ');
      for (let i = 1; i <= parts.length; i++) {
        const sub = parts.slice(0, i).join(' / ');
        if (!this.byPath.has(sub.toLowerCase())) out.set(sub.toLowerCase(), sub);
      }
    }
    return [...out.values()].sort((a, b) => a.split(' / ').length - b.split(' / ').length);
  }
  /** Create the listed paths; returns lower-cased full path → id for every path (created or existing). */
  async createAll(actor: Actor, paths: string[]) {
    await this.load();
    const map = new Map<string, string>();
    for (const p of [...paths].sort((a, b) => a.split(' / ').length - b.split(' / ').length)) {
      const existing = this.byPath.get(p.toLowerCase());
      if (existing) { map.set(p.toLowerCase(), existing.id); continue; }
      const parts = p.split(' / ');
      const parentPath = parts.slice(0, -1).join(' / ');
      const parentId = parentPath ? map.get(parentPath.toLowerCase()) ?? this.byPath.get(parentPath.toLowerCase())?.id ?? null : null;
      const isLeaf = !paths.some((o) => o.toLowerCase().startsWith(p.toLowerCase() + ' / '));
      const loc = await createLocation(actor, { name: parts[parts.length - 1], parentId, type: isLeaf ? 'BRANCH' : parts.length === 1 ? 'REGION' : 'OTHER' }, this.db);
      map.set(p.toLowerCase(), loc.id);
      this.byPath.set(p.toLowerCase(), loc as Location);
    }
    return map;
  }
}
