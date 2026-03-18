/**
 * 简单的内存缓存模块
 * 支持 TTL 过期和手动刷新
 */

class Cache {
  constructor() {
    this.store = new Map();
    this.lastUpdated = new Map();
  }

  set(key, value) {
    this.store.set(key, value);
    this.lastUpdated.set(key, Date.now());
  }

  get(key) {
    return this.store.get(key) || null;
  }

  getAge(key) {
    const ts = this.lastUpdated.get(key);
    return ts ? Date.now() - ts : Infinity;
  }

  getLastUpdated(key) {
    return this.lastUpdated.get(key) || null;
  }

  /** 获取全部缓存数据的快照 */
  snapshot() {
    const result = {};
    for (const [key, value] of this.store) {
      result[key] = {
        data: value,
        updatedAt: this.lastUpdated.get(key),
        ageSeconds: Math.round((Date.now() - this.lastUpdated.get(key)) / 1000),
      };
    }
    return result;
  }
}

module.exports = new Cache();
