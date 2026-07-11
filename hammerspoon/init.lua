-- Hammerspoon config: devbox session widget (always-on-top floating panel)
-- Refreshes every 30s. Draggable. Toggle with Ctrl+Opt+D.
require("hs.ipc")

local DEVBOX = os.getenv("HOME") .. "/Personal/dotfiles/bin/devbox"
local REFRESH = 30 -- seconds

-- Widget state
local canvas = nil
local timer = nil -- luacheck: ignore (hs.timer prevents GC via internal ref)
local visible = true
local widgetX = 40
local widgetY = 60
local widgetW = 320
local dragTap = nil
local currentSessions = {}

-- Colors
local bg = {red = 0.12, green = 0.12, blue = 0.14, alpha = 0.92}
local headerColor = {red = 0.6, green = 0.6, blue = 0.6, alpha = 1}
local greenColor = {red = 0.3, green = 0.78, blue = 0.38, alpha = 1}
local orangeColor = {red = 0.9, green = 0.6, blue = 0.2, alpha = 1}
local grayColor = {red = 0.45, green = 0.45, blue = 0.45, alpha = 1}
local pathColor = {red = 0.4, green = 0.4, blue = 0.4, alpha = 1}
local redColor = {red = 0.8, green = 0.3, blue = 0.3, alpha = 1}
local bellColor = {red = 1.0, green = 0.84, blue = 0.0, alpha = 1} -- bright yellow

local function ago(now, then_ts)
  local d = now - then_ts
  if d < 0 then d = 0 end
  if d < 60 then return d .. "s" end
  if d < 3600 then return math.floor(d / 60) .. "m" end
  if d < 86400 then return math.floor(d / 3600) .. "h" end
  return math.floor(d / 86400) .. "d"
end

local function shortenPath(path)
  if not path or path == "" then return "~" end
  local short = path:match("^/local/home/[^/]+/(.+)$")
    or path:match("^/home/[^/]+/(.+)$")
  if short then return "~/" .. short end
  if path:match("^/local/home/[^/]+$") or path:match("^/home/[^/]+$") then
    return "~"
  end
  return path
end

local function fetchSessions()
  local cmd = '/bin/bash -l -c "' .. DEVBOX .. ' status --raw" 2>/dev/null'
  local out, status = hs.execute(cmd)
  if not status or not out or out == "" then return {} end
  local sessions = {}
  for line in out:gmatch("[^\n]+") do
    local name, att, act, bell, cmd_s, path = line:match("^([^|]*)|([^|]*)|([^|]*)|([^|]*)|([^|]*)|(.*)$")
    if name and name ~= "" then
      table.insert(sessions, {
        name = name,
        attached = (att ~= "0" and att ~= ""),
        activity = tonumber(act) or 0,
        bell = (bell == "1"),
        cmd = cmd_s or "",
        path = path or ""
      })
    end
  end
  return sessions
end

-- Focus the Ghostty tab whose title contains "devbox:<name>". Tab titles are
-- set by the remote tmux (set-titles-string "devbox:#S"). Returns true if a
-- matching tab was found and pressed.
local function focusSession(name)
  local ghostty = hs.application.get("Ghostty")
  if not ghostty then return false end
  local ax = hs.axuielement.applicationElement(ghostty)
  local needle = "devbox:" .. name
  for _, win in ipairs(ax:attributeValue("AXWindows") or {}) do
    for _, child in ipairs(win:attributeValue("AXChildren") or {}) do
      if child:attributeValue("AXRole") == "AXTabGroup" then
        for _, tab in ipairs(child:attributeValue("AXChildren") or {}) do
          local title = tab:attributeValue("AXTitle") or ""
          if title:find(needle, 1, true) then
            tab:performAction("AXPress")
            ghostty:activate()
            return true
          end
        end
      end
    end
  end
  return false
end

-- Click on a session row: focus its Ghostty tab, or open a new Ghostty tab
-- attached to it if no tab exists yet.
local function clickSession(name)
  if focusSession(name) then return end
  -- No existing tab — open a new Ghostty window running devbox <name>.
  -- `ghostty -e` execs the command directly (no login wrapper).
  local devbox = os.getenv("HOME") .. "/Personal/dotfiles/bin/devbox"
  hs.task.new("/opt/homebrew/bin/ghostty", nil, {"-e", devbox, name}):start()
end

-- Dragging: on mouseDown inside the canvas, follow the mouse with an eventtap
-- until mouseUp. If the mouse barely moved, treat it as a click on the row.
local function startDrag(clickY)
  if dragTap then dragTap:stop() end
  local startMouse = hs.mouse.absolutePosition()
  local startTL = canvas:topLeft()
  local moved = false
  dragTap = hs.eventtap.new(
    {hs.eventtap.event.types.leftMouseDragged, hs.eventtap.event.types.leftMouseUp},
    function(e)
      if e:getType() == hs.eventtap.event.types.leftMouseUp then
        local tl = canvas:topLeft()
        widgetX, widgetY = tl.x, tl.y
        dragTap:stop()
        dragTap = nil
        if not moved then
          -- Click: map y offset to a session row
          local i = math.floor((clickY - 40) / 36) + 1 -- headerH+padY=40, lineH=36
          local s = currentSessions[i]
          if s then clickSession(s.name) end
        end
        return false
      end
      local m = hs.mouse.absolutePosition()
      if math.abs(m.x - startMouse.x) > 4 or math.abs(m.y - startMouse.y) > 4 then
        moved = true
      end
      if moved then
        canvas:topLeft({x = startTL.x + (m.x - startMouse.x), y = startTL.y + (m.y - startMouse.y)})
      end
      return false
    end)
  dragTap:start()
end

local function drawWidget(sessions)
  if canvas then canvas:delete() end

  local now = os.time()
  local lineH = 36
  local headerH = 30
  local padY = 10
  local h = headerH + padY + #sessions * lineH + 10
  if #sessions == 0 then h = headerH + padY + 24 end

  canvas = hs.canvas.new({x = widgetX, y = widgetY, w = widgetW, h = h})
  canvas:level(hs.canvas.windowLevels.floating)
  canvas:behavior(hs.canvas.windowBehaviors.canJoinAllSpaces)

  -- Background
  canvas:appendElements({
    type = "rectangle",
    action = "fill",
    roundedRectRadii = {xRadius = 10, yRadius = 10},
    fillColor = bg,
    trackMouseDown = true,
  })

  -- Header
  local attached = 0
  local bells = 0
  for _, s in ipairs(sessions) do
    if s.attached then attached = attached + 1 end
    if s.bell then bells = bells + 1 end
  end

  canvas:appendElements({
    type = "text",
    text = hs.styledtext.new("DEVBOX", {
      font = {name = "Menlo-Bold", size = 10},
      color = headerColor,
    }),
    frame = {x = 14, y = padY, w = 130, h = 16},
  })

  local countText, countColor
  if #sessions == 0 then
    countText = "unreachable"
    countColor = redColor
  elseif bells > 0 then
    countText = "🔔 " .. bells .. " need attention"
    countColor = bellColor
  else
    countText = attached .. "/" .. #sessions .. " attached"
    countColor = greenColor
  end
  canvas:appendElements({
    type = "text",
    text = hs.styledtext.new(countText, {
      font = {name = "Menlo", size = 10},
      color = countColor,
    }),
    frame = {x = widgetW - 160 - 14, y = padY, w = 160, h = 16},
    textAlignment = "right",
  })

  -- Sessions
  for i, s in ipairs(sessions) do
    local idle = ago(now, s.activity)
    local idleSec = now - s.activity
    local color
    if s.bell then
      color = bellColor -- needs attention: bright yellow
    elseif s.attached and idleSec < 3600 then
      color = greenColor
    elseif s.attached then
      color = orangeColor
    else
      color = grayColor
    end

    local icon
    if s.bell then
      icon = "🔔"
    elseif s.attached then
      icon = "●"
    else
      icon = "○"
    end
    local yPos = headerH + padY + (i - 1) * lineH

    -- Session name line
    canvas:appendElements({
      type = "text",
      text = hs.styledtext.new(icon .. " " .. s.name .. "  " .. (s.cmd ~= "" and s.cmd or "shell") .. " · " .. idle, {
        font = {name = "Menlo", size = 12},
        color = color,
      }),
      frame = {x = 14, y = yPos, w = widgetW - 28, h = 16},
    })

    -- Path line
    canvas:appendElements({
      type = "text",
      text = hs.styledtext.new("  " .. shortenPath(s.path), {
        font = {name = "Menlo", size = 10},
        color = pathColor,
      }),
      frame = {x = 14, y = yPos + 17, w = widgetW - 28, h = 14},
    })
  end

  canvas:mouseCallback(function(_c, msg, _id, _x, y) -- luacheck: no unused args
    if msg == "mouseDown" then startDrag(y) end
  end)
  canvas:canvasMouseEvents(true, false, false, false)

  if visible then canvas:show() end
end

function refresh()
  currentSessions = fetchSessions()
  drawWidget(currentSessions)
end

-- Toggle visibility: Ctrl+Opt+D
hs.hotkey.bind({"ctrl", "alt"}, "d", function()
  visible = not visible
  if canvas then
    if visible then canvas:show() else canvas:hide() end
  end
end)

-- Start
refresh()
timer = hs.timer.doEvery(REFRESH, refresh)
