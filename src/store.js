import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export class SubscriptionStore {
  constructor(file) {
    this.file = file;
    this.items = [];
    this.writeQueue = Promise.resolve();
  }

  async load() {
    try {
      const data = JSON.parse(await readFile(this.file, "utf8"));
      this.items = Array.isArray(data) ? data : [];
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  find(id, channelId) {
    return this.items.find((item) => item.id === id && item.channelId === channelId);
  }

  forChannel(channelId) {
    return this.items.filter((item) => item.channelId === channelId);
  }

  async add(item) {
    const duplicate = this.items.find(
      (existing) => existing.channelId === item.channelId && existing.url === item.url,
    );
    if (duplicate) return { item: duplicate, created: false };
    this.items.push(item);
    await this.save();
    return { item, created: true };
  }

  async remove(id, channelId) {
    const index = this.items.findIndex((item) => item.id === id && item.channelId === channelId);
    if (index < 0) return null;
    const [removed] = this.items.splice(index, 1);
    await this.save();
    return removed;
  }

  async save() {
    this.writeQueue = this.writeQueue.then(async () => {
      await mkdir(dirname(this.file), { recursive: true });
      const temporary = `${this.file}.tmp`;
      await writeFile(temporary, `${JSON.stringify(this.items, null, 2)}\n`, "utf8");
      await rename(temporary, this.file);
    });
    return this.writeQueue;
  }
}
