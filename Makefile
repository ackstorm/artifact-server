.PHONY: release

# make release VERSION=X.Y.Z — see docs/releasing.md.
release:
	@scripts/release.sh "$(VERSION)"
