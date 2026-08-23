/**
 * Minimal PPTX writer: one 16:9 slide per PNG, picture stretched to the
 * slide bounds. Same file shape the old python-pptx `_assemble_pptx`
 * produced — no Python, no pptxgenjs.
 *
 * A .pptx is a ZIP of OOXML. This writes that ZIP with Node zlib only.
 */
import { deflateRawSync, crc32 } from "node:zlib";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const SLIDE_WIDTH_EMU = 12_192_000; // 13.333" * 914400
const SLIDE_HEIGHT_EMU = 6_858_000; // 7.5" * 914400

interface ZipEntry {
	name: string;
	data: Buffer;
}

function utf8(s: string): Buffer {
	return Buffer.from(s, "utf8");
}

function u16(n: number): Buffer {
	const b = Buffer.alloc(2);
	b.writeUInt16LE(n);
	return b;
}

function u32(n: number): Buffer {
	const b = Buffer.alloc(4);
	b.writeUInt32LE(n >>> 0);
	return b;
}

function buildZip(entries: ZipEntry[]): Buffer {
	const locals: Buffer[] = [];
	const centrals: Buffer[] = [];
	let offset = 0;

	for (const entry of entries) {
		const name = utf8(entry.name);
		const raw = entry.data;
		const compressed = deflateRawSync(raw);
		const crc = crc32(raw) >>> 0;
		const local = Buffer.concat([
			u32(0x04034b50),
			u16(20),
			u16(0),
			u16(8),
			u16(0),
			u16(0),
			u32(crc),
			u32(compressed.length),
			u32(raw.length),
			u16(name.length),
			u16(0),
			name,
			compressed,
		]);
		locals.push(local);
		centrals.push(
			Buffer.concat([
				u32(0x02014b50),
				u16(20),
				u16(20),
				u16(0),
				u16(8),
				u16(0),
				u16(0),
				u32(crc),
				u32(compressed.length),
				u32(raw.length),
				u16(name.length),
				u16(0),
				u16(0),
				u16(0),
				u16(0),
				u32(0),
				u32(offset),
				name,
			]),
		);
		offset += local.length;
	}

	const central = Buffer.concat(centrals);
	const end = Buffer.concat([
		u32(0x06054b50),
		u16(0),
		u16(0),
		u16(entries.length),
		u16(entries.length),
		u32(central.length),
		u32(offset),
		u16(0),
	]);
	return Buffer.concat([...locals, central, end]);
}

function contentTypesXml(slideCount: number): string {
	const slides = Array.from({ length: slideCount }, (_, i) =>
		`    <Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`,
	).join("\n");
	return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
    <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
    <Default Extension="xml" ContentType="application/xml"/>
    <Default Extension="png" ContentType="image/png"/>
    <Default Extension="jpeg" ContentType="image/jpeg"/>
    <Default Extension="jpg" ContentType="image/jpeg"/>
    <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
    <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
    <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
    <Override PartName="/ppt/presProps.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presProps+xml"/>
    <Override PartName="/ppt/viewProps.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.viewProps+xml"/>
    <Override PartName="/ppt/tableStyles.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.tableStyles+xml"/>
    <Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>
    <Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>
    <Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>
${slides}
</Types>
`;
}

function rootRels(): string {
	return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
    <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
    <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
    <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>
`;
}

function escapeXml(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/**
 * Dublin Core metadata. Real PowerPoint always emits this; Keynote's
 * importer has been observed to reject an otherwise well-formed .pptx
 * ("file format is invalid") when docProps/core.xml + app.xml are absent,
 * even though unzip/python-pptx/libmagic all accept the same file fine.
 */
function coreXml(title: string): string {
	const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
	return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <dc:title>${escapeXml(title)}</dc:title>
    <dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>
    <dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>
</cp:coreProperties>
`;
}

function appXml(slideCount: number): string {
	const titlesOfParts = Array.from({ length: slideCount }, () => `        <vt:lpstr>Slide</vt:lpstr>`).join("\n");
	return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
    <Application>Hypatia</Application>
    <PresentationFormat>Widescreen</PresentationFormat>
    <Slides>${slideCount}</Slides>
    <HeadingPairs>
        <vt:vector size="2" baseType="variant">
            <vt:variant><vt:lpstr>Slide Titles</vt:lpstr></vt:variant>
            <vt:variant><vt:i4>${slideCount}</vt:i4></vt:variant>
        </vt:vector>
    </HeadingPairs>
    <TitlesOfParts>
        <vt:vector size="${slideCount}" baseType="lpstr">
${titlesOfParts}
        </vt:vector>
    </TitlesOfParts>
</Properties>
`;
}

function presPropsXml(): string {
	return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentationPr xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>
`;
}

function viewPropsXml(): string {
	return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:viewPr xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
    <p:normalViewPr>
        <p:restoredLeft sz="15620"/>
        <p:restoredTop sz="94660"/>
    </p:normalViewPr>
    <p:slideViewPr>
        <p:cSldViewPr>
            <p:cViewPr varScale="1">
                <p:origin x="0" y="0"/>
                <p:scale><a:sx n="1" d="1"/><a:sy n="1" d="1"/></p:scale>
            </p:cViewPr>
        </p:cSldViewPr>
    </p:slideViewPr>
</p:viewPr>
`;
}

function tableStylesXml(): string {
	return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:tblStyleLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>
`;
}

function presentationXml(slideCount: number): string {
	const sldIdLst = Array.from(
		{ length: slideCount },
		(_, i) => `            <p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`,
	).join("\n");
	return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
    <p:sldMasterIdLst>
        <p:sldMasterId id="2147483648" r:id="rId1"/>
    </p:sldMasterIdLst>
    <p:sldIdLst>
${sldIdLst}
    </p:sldIdLst>
    <p:sldSz cx="${SLIDE_WIDTH_EMU}" cy="${SLIDE_HEIGHT_EMU}"/>
    <p:notesSz cx="6858000" cy="9144000"/>
    <p:defaultTextStyle>
        <a:defPPr><a:defRPr lang="en-US"/></a:defPPr>
        <a:lvl1pPr algn="l"><a:defRPr sz="1800" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/></a:defRPr></a:lvl1pPr>
    </p:defaultTextStyle>
</p:presentation>
`;
}

function presentationRels(slideCount: number): string {
	const slides = Array.from(
		{ length: slideCount },
		(_, i) =>
			`    <Relationship Id="rId${i + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`,
	).join("\n");
	const presPropsId = slideCount + 2;
	const viewPropsId = slideCount + 3;
	const tableStylesId = slideCount + 4;
	return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
    <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>
${slides}
    <Relationship Id="rId${presPropsId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/presProps" Target="presProps.xml"/>
    <Relationship Id="rId${viewPropsId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/viewProps" Target="viewProps.xml"/>
    <Relationship Id="rId${tableStylesId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/tableStyles" Target="tableStyles.xml"/>
</Relationships>
`;
}

function slideXml(): string {
	return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
    <p:cSld>
        <p:spTree>
            <p:nvGrpSpPr>
                <p:cNvPr id="1" name=""/>
                <p:cNvGrpSpPr/>
                <p:nvPr/>
            </p:nvGrpSpPr>
            <p:grpSpPr>
                <a:xfrm>
                    <a:off x="0" y="0"/>
                    <a:ext cx="0" cy="0"/>
                    <a:chOff x="0" y="0"/>
                    <a:chExt cx="0" cy="0"/>
                </a:xfrm>
            </p:grpSpPr>
            <p:pic>
                <p:nvPicPr>
                    <p:cNvPr id="2" name="Picture"/>
                    <p:cNvPicPr>
                        <a:picLocks noChangeAspect="1"/>
                    </p:cNvPicPr>
                    <p:nvPr/>
                </p:nvPicPr>
                <p:blipFill>
                    <a:blip r:embed="rId2"/>
                    <a:stretch>
                        <a:fillRect/>
                    </a:stretch>
                </p:blipFill>
                <p:spPr>
                    <a:xfrm>
                        <a:off x="0" y="0"/>
                        <a:ext cx="${SLIDE_WIDTH_EMU}" cy="${SLIDE_HEIGHT_EMU}"/>
                    </a:xfrm>
                    <a:prstGeom prst="rect">
                        <a:avLst/>
                    </a:prstGeom>
                </p:spPr>
            </p:pic>
        </p:spTree>
    </p:cSld>
    <p:clrMapOvr>
        <a:masterClrMapping/>
    </p:clrMapOvr>
</p:sld>
`;
}

function slideRelsFor(index: number, ext: string): string {
	// Every real slide declares which slideLayout it's based on via its own
	// _rels — without it the slide has no resolvable layout at all, which is
	// structurally incomplete (not just missing-optional-metadata) and is
	// what was actually causing Keynote's "file format is invalid" rejection
	// (confirmed by diffing against real python-pptx/PowerPoint output).
	return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
    <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
    <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image${index}.${ext}"/>
</Relationships>
`;
}

function slideMasterXml(): string {
	return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
    <p:cSld>
        <p:bg>
            <p:bgRef idx="1001">
                <a:schemeClr val="bg1"/>
            </p:bgRef>
        </p:bg>
        <p:spTree>
            <p:nvGrpSpPr>
                <p:cNvPr id="1" name=""/>
                <p:cNvGrpSpPr/>
                <p:nvPr/>
            </p:nvGrpSpPr>
            <p:grpSpPr>
                <a:xfrm>
                    <a:off x="0" y="0"/>
                    <a:ext cx="0" cy="0"/>
                    <a:chOff x="0" y="0"/>
                    <a:chExt cx="0" cy="0"/>
                </a:xfrm>
            </p:grpSpPr>
        </p:spTree>
    </p:cSld>
    <p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>
    <p:sldLayoutIdLst>
        <p:sldLayoutId id="2147483649" r:id="rId1"/>
    </p:sldLayoutIdLst>
    <p:txStyles>
        <p:titleStyle>
            <a:lvl1pPr algn="ctr"><a:defRPr sz="4400" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mj-lt"/></a:defRPr></a:lvl1pPr>
        </p:titleStyle>
        <p:bodyStyle>
            <a:lvl1pPr marL="342900" indent="-342900" algn="l"><a:defRPr sz="3200" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/></a:defRPr></a:lvl1pPr>
        </p:bodyStyle>
        <p:otherStyle>
            <a:lvl1pPr algn="l"><a:defRPr sz="1800" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/></a:defRPr></a:lvl1pPr>
        </p:otherStyle>
    </p:txStyles>
</p:sldMaster>
`;
}

function slideMasterRels(): string {
	return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
    <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
    <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>
</Relationships>
`;
}

function slideLayoutXml(): string {
	return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank" preserve="1">
    <p:cSld name="Blank">
        <p:spTree>
            <p:nvGrpSpPr>
                <p:cNvPr id="1" name=""/>
                <p:cNvGrpSpPr/>
                <p:nvPr/>
            </p:nvGrpSpPr>
            <p:grpSpPr>
                <a:xfrm>
                    <a:off x="0" y="0"/>
                    <a:ext cx="0" cy="0"/>
                    <a:chOff x="0" y="0"/>
                    <a:chExt cx="0" cy="0"/>
                </a:xfrm>
            </p:grpSpPr>
        </p:spTree>
    </p:cSld>
    <p:clrMapOvr>
        <a:masterClrMapping/>
    </p:clrMapOvr>
</p:sldLayout>
`;
}

function slideLayoutRels(): string {
	return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
    <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>
</Relationships>
`;
}

function themeXml(): string {
	return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office Theme">
    <a:themeElements>
        <a:clrScheme name="Office">
            <a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>
            <a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>
            <a:dk2><a:srgbClr val="44546A"/></a:dk2>
            <a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>
            <a:accent1><a:srgbClr val="4472C4"/></a:accent1>
            <a:accent2><a:srgbClr val="ED7D31"/></a:accent2>
            <a:accent3><a:srgbClr val="A5A5A5"/></a:accent3>
            <a:accent4><a:srgbClr val="FFC000"/></a:accent4>
            <a:accent5><a:srgbClr val="5B9BD5"/></a:accent5>
            <a:accent6><a:srgbClr val="70AD47"/></a:accent6>
            <a:hlink><a:srgbClr val="0563C1"/></a:hlink>
            <a:folHlink><a:srgbClr val="954F72"/></a:folHlink>
        </a:clrScheme>
        <a:fontScheme name="Office">
            <a:majorFont>
                <a:latin typeface="Calibri Light"/>
                <a:ea typeface=""/>
                <a:cs typeface=""/>
            </a:majorFont>
            <a:minorFont>
                <a:latin typeface="Calibri"/>
                <a:ea typeface=""/>
                <a:cs typeface=""/>
            </a:minorFont>
        </a:fontScheme>
        <a:fmtScheme name="Office">
            <a:fillStyleLst>
                <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
                <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
                <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
            </a:fillStyleLst>
            <a:lnStyleLst>
                <a:ln w="12700" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>
                <a:ln w="12700" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>
                <a:ln w="12700" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>
            </a:lnStyleLst>
            <a:effectStyleLst>
                <a:effectStyle><a:effectLst/></a:effectStyle>
                <a:effectStyle><a:effectLst/></a:effectStyle>
                <a:effectStyle><a:effectLst/></a:effectStyle>
            </a:effectStyleLst>
            <a:bgFillStyleLst>
                <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
                <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
                <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
            </a:bgFillStyleLst>
        </a:fmtScheme>
    </a:themeElements>
</a:theme>
`;
}

function imageExt(path: string): string {
	const ext = path.split(".").pop()?.toLowerCase() ?? "png";
	if (ext === "jpg" || ext === "jpeg") return "jpeg";
	return "png";
}

export function assemblePptxFromImages(imagePaths: string[], outputPath: string, title = ""): void {
	if (!imagePaths.length) throw new Error("assemblePptxFromImages requires at least one image");
	const entries: ZipEntry[] = [
		{ name: "[Content_Types].xml", data: utf8(contentTypesXml(imagePaths.length)) },
		{ name: "_rels/.rels", data: utf8(rootRels()) },
		{ name: "docProps/core.xml", data: utf8(coreXml(title)) },
		{ name: "docProps/app.xml", data: utf8(appXml(imagePaths.length)) },
		{ name: "ppt/presentation.xml", data: utf8(presentationXml(imagePaths.length)) },
		{ name: "ppt/_rels/presentation.xml.rels", data: utf8(presentationRels(imagePaths.length)) },
		{ name: "ppt/presProps.xml", data: utf8(presPropsXml()) },
		{ name: "ppt/viewProps.xml", data: utf8(viewPropsXml()) },
		{ name: "ppt/tableStyles.xml", data: utf8(tableStylesXml()) },
		{ name: "ppt/slideMasters/slideMaster1.xml", data: utf8(slideMasterXml()) },
		{ name: "ppt/slideMasters/_rels/slideMaster1.xml.rels", data: utf8(slideMasterRels()) },
		{ name: "ppt/slideLayouts/slideLayout1.xml", data: utf8(slideLayoutXml()) },
		{ name: "ppt/slideLayouts/_rels/slideLayout1.xml.rels", data: utf8(slideLayoutRels()) },
		{ name: "ppt/theme/theme1.xml", data: utf8(themeXml()) },
	];

	imagePaths.forEach((imagePath, i) => {
		const n = i + 1;
		const ext = imageExt(imagePath);
		entries.push({ name: `ppt/slides/slide${n}.xml`, data: utf8(slideXml()) });
		entries.push({ name: `ppt/slides/_rels/slide${n}.xml.rels`, data: utf8(slideRelsFor(n, ext === "jpeg" ? "jpeg" : "png")) });
		entries.push({ name: `ppt/media/image${n}.${ext === "jpeg" ? "jpeg" : "png"}`, data: readFileSync(imagePath) });
	});

	mkdirSync(dirname(outputPath) || ".", { recursive: true });
	writeFileSync(outputPath, buildZip(entries));
}
