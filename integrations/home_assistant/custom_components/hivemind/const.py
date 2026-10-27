"""Constants for the HiveMind integration."""

DOMAIN = "hivemind"

CONF_CANVASES = "canvases"
CONF_BUTTON_TEXT = "button_text"

DEFAULT_BUTTON_TEXT = "Go"

SERVICE_RUN_CANVAS = "run_canvas"
ATTR_CANVAS = "canvas"
ATTR_TEXT = "text"
ATTR_CONFIG_ENTRY = "config_entry_id"

EVENT_RESPONSE = "hivemind_response"

# A canvas with several models can take minutes, especially when local models have to load first.
RUN_TIMEOUT = 600
