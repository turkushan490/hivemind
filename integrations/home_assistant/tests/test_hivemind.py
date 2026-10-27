"""Config flow, setup, the run_canvas action, the conversation agent and the buttons."""

import aiohttp

from homeassistant import config_entries
from homeassistant.components import conversation
from homeassistant.core import Context, HomeAssistant
from homeassistant.data_entry_flow import FlowResultType
from homeassistant.exceptions import HomeAssistantError
from homeassistant.setup import async_setup_component
import pytest
from pytest_homeassistant_custom_component.common import MockConfigEntry, async_capture_events
from pytest_homeassistant_custom_component.test_util.aiohttp import AiohttpClientMocker

from custom_components.hivemind.const import DOMAIN

URL = "http://hivemind.local:4820"
MODELS = {"object": "list", "data": [{"id": "c1", "object": "model", "name": "Kitchen helper"}, {"id": "c2", "object": "model", "name": "Council"}]}


def answer(text: str) -> dict:
    return {"id": "chatcmpl-1", "object": "chat.completion", "choices": [{"index": 0, "message": {"role": "assistant", "content": text}, "finish_reason": "stop"}]}


async def setup_entry(hass: HomeAssistant, aioclient_mock: AiohttpClientMocker) -> MockConfigEntry:
    aioclient_mock.get(f"{URL}/v1/models", json=MODELS)
    entry = MockConfigEntry(domain=DOMAIN, data={"url": URL, "token": "hm_x"}, unique_id=URL, title="HiveMind")
    entry.add_to_hass(hass)
    assert await async_setup_component(hass, DOMAIN, {})
    await hass.async_block_till_done()
    return entry


async def test_config_flow(hass: HomeAssistant, aioclient_mock: AiohttpClientMocker) -> None:
    aioclient_mock.get(f"{URL}/v1/models", json=MODELS)
    result = await hass.config_entries.flow.async_init(DOMAIN, context={"source": config_entries.SOURCE_USER})
    assert result["type"] is FlowResultType.FORM
    result = await hass.config_entries.flow.async_configure(result["flow_id"], {"url": "hivemind.local:4820/v1/", "token": " hm_x "})
    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert result["data"] == {"url": URL, "token": "hm_x"}
    assert aioclient_mock.mock_calls[0][3]["Authorization"] == "Bearer hm_x"


async def test_config_flow_errors(hass: HomeAssistant, aioclient_mock: AiohttpClientMocker) -> None:
    aioclient_mock.get(f"{URL}/v1/models", status=401, json={"error": {"message": "bad"}})
    result = await hass.config_entries.flow.async_init(DOMAIN, context={"source": config_entries.SOURCE_USER})
    result = await hass.config_entries.flow.async_configure(result["flow_id"], {"url": URL, "token": "wrong"})
    assert result["errors"] == {"base": "invalid_auth"}
    aioclient_mock.get("http://nowhere.invalid:1/v1/models", exc=aiohttp.ClientConnectionError("refused"))
    result = await hass.config_entries.flow.async_configure(result["flow_id"], {"url": "http://nowhere.invalid:1", "token": "x"})
    assert result["errors"] == {"base": "cannot_connect"}


async def test_setup_creates_agents_and_buttons(hass: HomeAssistant, aioclient_mock: AiohttpClientMocker) -> None:
    entry = await setup_entry(hass, aioclient_mock)
    assert entry.state is config_entries.ConfigEntryState.LOADED
    assert hass.states.get("button.hivemind_run_kitchen_helper") is not None
    assert hass.states.get("conversation.hivemind_council") is not None


async def test_run_canvas_action(hass: HomeAssistant, aioclient_mock: AiohttpClientMocker) -> None:
    await setup_entry(hass, aioclient_mock)
    aioclient_mock.post(f"{URL}/v1/chat/completions", json=answer("Pasta!"))
    result = await hass.services.async_call(DOMAIN, "run_canvas", {"canvas": "kitchen helper", "text": "Dinner?"}, blocking=True, return_response=True)
    assert result == {"response": "Pasta!", "canvas": "c1"}
    sent = aioclient_mock.mock_calls[-1][2]
    assert sent == {"model": "c1", "messages": [{"role": "user", "content": "Dinner?"}]}


async def test_run_canvas_error(hass: HomeAssistant, aioclient_mock: AiohttpClientMocker) -> None:
    await setup_entry(hass, aioclient_mock)
    aioclient_mock.post(f"{URL}/v1/chat/completions", status=500, json={"error": {"message": "The canvas gave no answer"}})
    with pytest.raises(HomeAssistantError, match="gave no answer"):
        await hass.services.async_call(DOMAIN, "run_canvas", {"canvas": "c1", "text": "x"}, blocking=True, return_response=True)


async def test_conversation_agent(hass: HomeAssistant, aioclient_mock: AiohttpClientMocker) -> None:
    await setup_entry(hass, aioclient_mock)
    aioclient_mock.post(f"{URL}/v1/chat/completions", json=answer("The lights are on."))
    result = await conversation.async_converse(hass, "are the lights on?", None, Context(), agent_id="conversation.hivemind_council")
    assert result.response.speech["plain"]["speech"] == "The lights are on."
    assert aioclient_mock.mock_calls[-1][2]["model"] == "c2"


async def test_button_press_fires_event(hass: HomeAssistant, aioclient_mock: AiohttpClientMocker) -> None:
    await setup_entry(hass, aioclient_mock)
    aioclient_mock.post(f"{URL}/v1/chat/completions", json=answer("Done"))
    events = async_capture_events(hass, "hivemind_response")
    await hass.services.async_call("button", "press", {"entity_id": "button.hivemind_run_kitchen_helper"}, blocking=True)
    await hass.async_block_till_done()
    assert events[0].data["response"] == "Done"
    assert hass.states.get("button.hivemind_run_kitchen_helper").attributes["last_response"] == "Done"


async def test_options_limit_canvases(hass: HomeAssistant, aioclient_mock: AiohttpClientMocker) -> None:
    entry = await setup_entry(hass, aioclient_mock)
    result = await hass.config_entries.options.async_init(entry.entry_id)
    result = await hass.config_entries.options.async_configure(result["flow_id"], {"canvases": ["c2"], "button_text": "Start"})
    assert result["type"] is FlowResultType.CREATE_ENTRY
    await hass.async_block_till_done()
    assert hass.states.get("button.hivemind_run_kitchen_helper") is None or hass.states.get("button.hivemind_run_kitchen_helper").state == "unavailable"
    assert hass.states.get("button.hivemind_run_council") is not None
