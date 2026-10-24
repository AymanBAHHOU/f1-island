// Docking (Windows/Linux): dropping the island near the top edge of a display,
// anywhere along it, docks it; it then slides to the centre. Dropping it lower
// leaves it floating.

// pos and home are window origins ({ x, y }); home is the docked spot. Only
// the height matters: anything above it counts as near (it's clamped to the
// screen top anyway), and below it must be within snapPx.
function nearDock(pos, home, snapPx) {
  return pos.y - home.y < snapPx;
}

module.exports = { nearDock };
