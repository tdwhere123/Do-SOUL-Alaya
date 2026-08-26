import type { Mock } from "vitest";

type Procedure = (...args: never[]) => unknown;

export type TestMock<T extends Procedure = Procedure> = Mock<T>;
