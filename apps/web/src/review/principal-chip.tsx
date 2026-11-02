/** Up to two initials: the first letter of the first two words that start with a letter. */
export function initials(name: string): string {
  return name
    .split(/\s+/u)
    .filter((word) => /^\p{L}/u.test(word))
    .slice(0, 2)
    .map((word) => word.slice(0, 1).toUpperCase())
    .join("");
}

export function PrincipalChip({
  name,
  via = null,
}: {
  readonly name: string;
  readonly via?: string | null;
}) {
  return (
    <span className="as-principal-chip">
      <span aria-hidden="true" className="as-principal-chip__avatar">{initials(name)}</span>
      <span className="as-principal-chip__name">{name}</span>
      {via === null ? null : <span className="as-principal-chip__via">via {via}</span>}
    </span>
  );
}
