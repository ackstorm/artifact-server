/** Artifact Server's product mark: an isometric box, one artifact as a sealed package. */
export function ArtifactMark({className}: {readonly className?: string}) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.7"
      viewBox="0 0 24 24"
    >
      <path d="M12 2.75 20.25 7.5v9L12 21.25 3.75 16.5v-9Z" />
      <path d="M3.75 7.5 12 12.25 20.25 7.5M12 12.25v9" />
      <path d="M12 2.75 20.25 7.5 12 12.25 3.75 7.5Z" fill="currentColor" fillOpacity="0.28" />
    </svg>
  );
}
