-- Generate metadata.<ext>.lua files exactly the way KOReader's DocSettings:flush does:
-- "-- we can read Lua syntax here!\nreturn " .. dump(data, nil, true) .. "\n"
-- dump() is KOReader's frontend/dump.lua, fetched verbatim. orderedPairs is
-- KOReader's ffi/util ordering: keys sorted, numbers before strings.
package.path = "./?.lua;" .. package.path
package.loaded["ffi/util"] = {
    orderedPairs = function(t)
        local keys = {}
        for k in pairs(t) do keys[#keys + 1] = k end
        table.sort(keys, function(a, b)
            local ta, tb = type(a), type(b)
            if ta ~= tb then return ta == "number" end
            return a < b
        end)
        local i = 0
        return function()
            i = i + 1
            local k = keys[i]
            if k ~= nil then return k, t[k] end
        end
    end,
}
unpack = unpack or table.unpack
local dump = require("dump")

local function write(path, data)
    local file = assert(io.open(path, "w"))
    file:write("-- we can read Lua syntax here!\nreturn ", dump(data, nil, true), "\n")
    file:close()
end

local out = arg[1]
-- A book in progress with awkward highlights: quotes, newlines, braces, backslashes,
-- a decoy percent_finished/status inside annotations, stats and a string.
write(out .. "/reading.lua", {
    annotations = {
        {
            chapter = "Chapter 3: \"Fire\"",
            text = "He said { \"percent_finished\" = 0.99 }\nand then\tleft \\ quietly",
            note = "status = \"complete\"",
            percent_finished = 0.99,
            pos0 = "/body/DocFragment[12]/body/p[3]/text().0",
            datetime = "2026-10-28 21:14:03",
        },
        { text = "second highlight, ünïcödé — “curly”", page = 41 },
    },
    bookmarks = {},
    cre_dom_version = 20240114,
    doc_pages = 312,
    doc_path = "/mnt/us/documents/Butler, Octavia/Kindred.epub",
    doc_props = { authors = "Octavia E. Butler", title = "Kindred", language = "en" },
    font_face = "Noto Serif",
    highlight_drawer = "lighten",
    last_xpointer = "/body/DocFragment[12]/body/p[3]/text().0",
    partial_md5_checksum = "b3fb8f4f8448160365087d6ca05c7fa2",
    percent_finished = 0.6730769230769231,
    stats = { authors = "Octavia E. Butler", highlights = 2, notes = 1, pages = 312, status = "decoy" },
    summary = { modified = "2026-10-28", status = "reading" },
    ["tts.voice"] = "default",
})
write(out .. "/complete.lua", {
    doc_pages = 220,
    percent_finished = 1,
    summary = { modified = "2026-10-20", status = "complete", rating = 5, note = "Loved it" },
})
write(out .. "/abandoned.lua", {
    percent_finished = 0.12,
    summary = { status = "abandoned" },
})
-- A freshly opened book: KOReader has percent_finished but no summary yet.
write(out .. "/opened.lua", { doc_pages = 90, percent_finished = 0.0222222222 })
-- Large: 3000 highlights, to stay realistic about size and parse cost.
local many = {}
for i = 1, 3000 do
    many[i] = { text = string.rep("long highlighted passage \"quoted\" ", 4) .. i, page = i, chapter = "Part " .. i }
end
write(out .. "/large.lua", { annotations = many, percent_finished = 0.5, summary = { status = "reading" } })
print("ok")
