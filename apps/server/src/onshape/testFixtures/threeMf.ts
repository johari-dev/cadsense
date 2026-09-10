import { zip } from "./zip.ts";
export const threeMfXml = (count = 2, omitFirst = false) =>
  `<model xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:m="http://schemas.microsoft.com/3dmanufacturing/material/2015/02" unit="meter"><resources><m:colorgroup id="1"><m:color color="#404040FF"/><m:color color="#33FF33FF"/></m:colorgroup>${Array.from({ length: count }, (_, i) => `<object id="${i + 2}" name="Part ${i}" pid="1" pindex="0"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x=".001" y="0" z="0"/><vertex x="0" y=".001" z="0"/><vertex x="0" y="0" z=".001"/></vertices><triangles><triangle v1="0" v2="1" v3="2"/><triangle v1="0" v2="2" v3="3" p1="1"/></triangles></mesh></object>`).join("")}</resources><build>${Array.from({ length: count }, (_, i) => (omitFirst && i === 0 ? "" : `<item objectid="${i + 2}" transform="1 0 0 0 1 0 0 0 1 ${i * 0.01} 0 0"/>`)).join("")}</build></model>`;
export const threeMfArchive = (xml: string) =>
  zip([
    {
      name: "_rels/.rels",
      bytes: Buffer.from(
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="model" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel" Target="/3D/model.model"/></Relationships>',
      ),
    },
    { name: "3D/model.model", bytes: Buffer.from(xml) },
  ]);
