export const lifecycleTestSeam: {
  afterManagedFileInstalled?: (path: string) => void;
  beforeManagedFileCleanup?: (path: string) => void;
  duringManagedItemRemoval?: () => void;
} = {};
