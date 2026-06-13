import type { Mock } from "vitest";

type Procedure = (...args: any[]) => any;

export type TestMock<T extends Procedure = Procedure> = Mock<T>;
