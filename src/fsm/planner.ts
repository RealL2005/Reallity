export function extractChecklist(content: string): string[] {
  const items: string[] = [];

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    const checkbox = line.match(/^-\s*\[[ xX]\]\s+(.+)$/);
    const numbered = line.match(/^\d+[.)]\s+(.+)$/);
    const item = checkbox?.[1] ?? numbered?.[1];

    if (item) {
      items.push(item.trim());
    }
  }

  return items;
}
