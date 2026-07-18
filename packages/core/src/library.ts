import { z } from "zod";

import { FORMAT_IDS } from "./formats.js";

export const libraryItemSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    sourcePath: z.string().min(1),
    format: z.enum(FORMAT_IDS),
    addedAt: z.string().datetime(),
  })
  .readonly();

export type LibraryItem = z.infer<typeof libraryItemSchema>;

export class InMemoryLibraryRepository {
  readonly #items = new Map<string, LibraryItem>();

  add(item: LibraryItem): void {
    const parsed = libraryItemSchema.parse(item);

    if (this.#items.has(parsed.id)) {
      throw new Error(`Library item '${parsed.id}' already exists.`);
    }

    this.#items.set(parsed.id, parsed);
  }

  list(): LibraryItem[] {
    return [...this.#items.values()];
  }

  get(id: string): LibraryItem | undefined {
    return this.#items.get(id);
  }

  remove(id: string): LibraryItem | undefined {
    const item = this.#items.get(id);
    this.#items.delete(id);
    return item;
  }
}
