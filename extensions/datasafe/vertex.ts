import type { StreamOptions } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { Policy } from "./guard.ts";

const US_REGION = /^us(?:-[a-z]+\d+)?$/;

function assertUSRegion(options: StreamOptions | undefined) {
	if (options?.apiKey) throw new Error("Datasafe blocked Vertex API-key mode, which uses the global endpoint");

	const location = Value.Check(Type.Object({ location: Type.String() }), options)
		? options.location
		: options?.env?.GOOGLE_CLOUD_LOCATION || process.env.GOOGLE_CLOUD_LOCATION;

	if (!location || !US_REGION.test(location)) {
		throw new Error(`Datasafe blocked Vertex location outside a US region: ${location ?? "unset"}`);
	}
}

export const vertexUSPolicy: Policy = { check: assertUSRegion };
