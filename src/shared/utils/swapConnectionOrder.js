/**
 * Swap two account rows and stamp 1-based priority ranks on the whole list.
 *
 * Connection lists are stored as 1..N (see reorderInTx). Writing only the
 * two swapped slots left tied rows (API-key adds default to priority 1)
 * sitting on rank 1, so a neighbor demoted to 2 sorted below them.
 *
 * @param {Array<{priority?: number}>} connections
 * @param {number} index1
 * @param {number} index2
 * @returns {Array|null} next list, or null when the indexes are not a swap
 */
export function swapConnectionOrder(connections, index1, index2) {
  if (!Array.isArray(connections)) return null;
  const last = connections.length - 1;
  if (
    !Number.isInteger(index1) ||
    !Number.isInteger(index2) ||
    index1 < 0 ||
    index2 < 0 ||
    index1 > last ||
    index2 > last ||
    index1 === index2
  ) {
    return null;
  }

  const next = connections.slice();
  const first = next[index1];
  next[index1] = next[index2];
  next[index2] = first;
  return next.map((row, index) => ({ ...row, priority: index + 1 }));
}

/**
 * Persist the visible list as 1-based ranks.
 * @param {Array<{id: string, priority?: number}>} connections
 * @returns {Array<{id: string, priority: number}>}
 */
export function swappedPriorityWrites(connections) {
  if (!Array.isArray(connections)) return [];
  return connections.map((row, index) => ({
    id: row.id,
    priority: index + 1,
  }));
}


