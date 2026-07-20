export const initializationTestSeam: {
  afterVersionZeroPreflight?: () => void;
  duringV1ToV2Migration?: () => void;
  duringV2ToV3Migration?: () => void;
  duringV3ToV4Migration?: () => void;
  duringV4ToV5Migration?: () => void;
} = {};
