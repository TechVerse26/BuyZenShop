/* <option> / <optgroup> markup for a district <select>, grouped by division (checkout and the address book share it). */
import { html } from '../../core/dom.js';
import { DIVISIONS } from '../../shared/constants.js';

export const districtOptions = (selected = '') => html`${Object.entries(DIVISIONS).map(([division, list]) => html`<optgroup label="${division}">${list.map((d) => html`<option value="${d}" ${d === selected ? 'selected' : ''}>${d}</option>`)}</optgroup>`)}`;
